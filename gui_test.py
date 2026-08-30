import sys
import pygame
import base_petri as pt

class Button:
    def __init__(self, name:str, pos:tuple, action:callable, size:tuple=(100,50),color:tuple=(0, 128, 255)):
        self.name = name
        self.action = lambda: action()
        self.pos = pos
        self.color = color
        self.rect = pygame.Rect(pos[0], pos[1], size[0], size[1])  

    def draw(self, screen):
        pygame.draw.rect(screen, self.color, self.rect,border_radius= 7)  # Draw button rectangle

    def is_clicked(self, mouse_pos):
        return self.rect.collidepoint(mouse_pos)

    def animate(self,screen):
        pass

class ButtonCircle(Button):
    def __init__(self, name:str, pos:tuple, action:callable, radius:int=25,color:tuple=(212, 15, 10)):
        super().__init__(name, pos, action,size=(radius*2, radius*2), color=color)
        self.radius = radius
        self.rect = pygame.Rect(pos[0]-radius, pos[1]-radius, radius*2, radius*2)  # Update rect for circle

    def draw(self, screen):
        pygame.draw.circle(screen, self.color, self.pos, self.radius)  # Draw button circle

class Menu:
    def __init__(self,screen,hide = True):
        self.buttons = []
        self.screen = screen
        self.surface = pygame.Surface((screen.get_width(), screen.get_height()//6))  # Example size
        self.rect = pygame.Rect(0, 0, self.screen.get_width(), self.screen.get_height()//6)  # Example size and position
        self.og_rect = pygame.Rect(0, 0, self.screen.get_width(), self.screen.get_height()//6)  # Store the original rect for reference
        self.add_button(Button("Add State", (10, 10), lambda: print("Add State Clicked")))
        self.add_button(Button("Add Transition", (120, 10), lambda: print("Add Transition Clicked")))
        self.add_button(Button("Add Action", (230, 10), lambda: print("Add Action Clicked")))
        self.add_button(Button("Turn on Grid", (340, 10), size=(25,25),action= lambda: print("Turn on grid")))
        self.add_button(ButtonCircle("Quit", (self.screen.get_width() - 30, 30), lambda: [pygame.quit(), sys.exit()], radius=25))
        self.showing = True

        self.hide = hide
        if self.hide:
            self.hide_speed = 3  # Speed at which the menu hides/shows

    def add_button(self, button: Button):
        self.buttons.append(button)

    def draw(self, screen):
        if self.hide:
            m_pos = pygame.mouse.get_pos()
            if not self.og_rect.collidepoint(m_pos):
                if self.showing:
                    self.rect.y -= self.hide_speed
                    if self.rect.y < -self.rect.height:
                        self.rect.y = -self.rect.height
                        self.showing = False
                #TODO:smooth animation
            else:
                self.showing = True
                self.rect.y = min(0, self.rect.y+self.hide_speed)  # Move to original position

        if self.hide and not self.showing:
            return  # Don't draw the menu if it's hidden
        pygame.draw.rect(self.surface, (200, 200, 200, 80), self.rect)  # Draw menu background
        for button in self.buttons:
            button.draw(self.surface)
        screen.blit(self.surface, self.rect.topleft)  # Draw the menu surface onto the main screen

    def handle_event(self, event):
        if event.type == pygame.MOUSEBUTTONDOWN:
            mouse_pos = event.pos
            for button in self.buttons:
                if button.is_clicked(mouse_pos):
                    button.action()

class Canvas:
    def __init__(self,screen,background = (255,255,255)):
        self.screen = screen
        self.background = background
        self.surface = pygame.Surface((2000,2000))  # bigger surface for drawing states, transitions, and actions
        self.init_pos = (-1000, -1000)  # Initial position of the canvas
        self.pos = self.init_pos  # Current position of the canvas
        #self.grid_x_step = self.screen.widht//5
        #self.grid_y_step = self.screen.widht//5

        self.dragging = False
        self.last_mouse_pos = (0,0)

        self.test_button = Button("Test", (1100, 1010), lambda: print("Test Clicked"))

    #def creat_grid(self):
    #    self.hl , self.vl = [], []
    #    for i in range(0,self.surface.width,5):
    #        self.vl.append(i), self.hl.append(i)

    def draw_grid(self):
        pass # for vertical lines pygame.draw_line ...

    def update_grid(self):
        pass #atualize the list of printable lines

    def draw(self, screen,ents):
        self.surface.fill(self.background)
        self.test_button.draw(self.surface)  
        self.screen.blit(self.surface, self.pos)  # Draw canvas background
        # Here goes code to draw the states, transitions, and actions

    def handle_event(self, event):
        if event.type == pygame.MOUSEBUTTONDOWN:
            if event.button == 1:  # Left mouse button
                self.dragging = True
                self.last_mouse_pos = event.pos
        elif event.type == pygame.MOUSEBUTTONUP:
            if event.button == 1:  # Left mouse button
                self.dragging = False
        elif event.type == pygame.MOUSEMOTION and getattr(self, 'dragging', True):
            mouse_x, mouse_y = event.pos
            last_x, last_y = self.last_mouse_pos
            dx = mouse_x - last_x
            dy = mouse_y - last_y
            self.pos = (self.pos[0] + dx, self.pos[1] + dy)
            self.last_mouse_pos = event.pos
        # Handle events related to the canvas (e.g., dragging states, creating transitions, etc.)

class Net_handler:
    def __init__(self,canvas):
        self.canvas = canvas
        self.net = None

    def addNet(self,NET):
        self.net = NET

    

class GUI:
    def __init__(self):
        self.petri = pt.PETRI
        self.gate = Net_handler
        self.screen = pygame.display.set_mode((800, 600))
        pygame.display.set_caption("Petri Net GUI")
        self.clock = pygame.time.Clock()
        self.running = True
        self.menu = Menu(self.screen)
        self.canvas = Canvas(self.screen)

    def run(self):
        while self.running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False

                self.canvas.handle_event(event)
                self.menu.handle_event(event)

            self.screen.fill((255, 255, 255))
            self.canvas.draw(self.screen,None)
            self.menu.draw(self.screen)
            # Here you would add code to draw the states, transitions, and actions
            pygame.display.flip()
            self.clock.tick(60)

        pygame.quit()

if __name__ == "__main__":
    gui = GUI()
    gui.run()