class PETRI:
    """The actions to the objects will be handled by this class, 
    which will be the main class to handle the objects and their interactions. 
    The PETRI class will only be used to define the structure of the Petri net,
    including its states, transitions, and actions."""
    def __init__(self,name):
        self.name = name
        self.states = {}
        self.transitions = {}
        self.actions = {}
        self.count_t = 0

    def add_ficha(self,place_name:str, ficha_count:int):
        if place_name in self.states:
            state = self.states[place_name]
            if not hasattr(state, 'ficha_count'):
                state.ficha_count = 0
            state.ficha_count += ficha_count
        else:
            print(f"State '{place_name}' does not exist. Cannot add ficha.")

    def add_state(self, state: 'State'):
        self.states[state.name] = state

    def add_transition(self, transition: 'Transition'):
        self.transitions[transition.name] = transition

    def add_action(self, action: 'Action'):
        self.actions[action.name] = action

    def show_attributes(self):
        print("----------------------------------")
        print(f"PETRI Net Name: {self.name}")
        print("----------------------------------")
        print("States:")
        for state in self.states.values():
            print(f"  - {state.name}: {state.description} | Fichas: {state.ficha_count}")
        print("----------------------------------")
        print("Transitions:")
        for transition in self.transitions.values():
            print(f"  - {transition.name}: {transition.description} (from {transition.source.name} to {transition.target.name})")
        print("----------------------------------")
        print("Actions:")
        for action in self.actions.values():
            print(f"  - {action.name}: {action.description} (enum: {action.enum})")

    def return_attr(self):
        return {"name":self.name,"states":self.states,"actions":self.actions,"transitions":self.transitions}

    def EXPORT(self):
        return {"states":self.states, "transitions":self.transitions, "actions":self.actions}

class State:
    def __init__(self, name:str, description:str = ""):
        self.name = name
        self.description = description
        self.transitions = {}
        self.ficha_count = 0  # Initialize ficha count to 0

class Transition:
    def __init__(self, name:str, description:str, source:State, target:State):
        self.name = name
        self.description = description
        self.source = source
        self.target = target

class Action:
    def __init__(self, name:str, description:str,enum):
        self.name = name
        self.description = description
        self.enum = enum

if __name__ == "__main__":

    Petri = PETRI("My Petri Net")
    print("PETRI Net construction via CLI")

    while True:
        print("\nChoose an option:")
        print("1. Add State")
        print("2. Add Transition")
        print("3. Add Action")
        print("4. Add Ficha")
        print("5. Show Petri Net attributes")
        print("6. Exit")

        choice = input("Enter your choice: ")

        if choice == "1":
            state_name = input("Enter state name: ")
            state_description = input("Enter state description: ")
            new_state = State(state_name, state_description)
            Petri.add_state(new_state)
            print(f"State '{state_name}' added.")

        elif choice == "2":
            transition_name = input("Enter transition name: ")
            transition_description = input("Enter transition description: ")
            source_name = input("Enter source state name: ")
            target_name = input("Enter target action name: ")

            if (source_name in Petri.states and target_name in Petri.actions):
                for t in Petri.transitions.values():
                    if t.source.name == source_name and t.target.name == target_name:
                        print(f"A transition from '{source_name}' to '{target_name}' already exists.")
                        break
                source = Petri.states[source_name]
                target = Petri.actions[target_name]
                new_transition = Transition(transition_name, transition_description, source, target)
                Petri.add_transition(new_transition)
                print(f"Transition '{transition_name}' added.")
            elif (source_name in Petri.actions and target_name in Petri.states):
                for t in Petri.transitions.values():
                    if t.source.name == source_name and t.target.name == target_name:
                        print(f"A transition from '{source_name}' to '{target_name}' already exists.")
                        break
                source = Petri.actions[source_name]
                target = Petri.states[target_name]
                new_transition = Transition(transition_name, transition_description, source, target)
                Petri.add_transition(new_transition)
                print(f"Transition '{transition_name}' added.")
            else:
                print("Source or target does not exist or it's not a state action pair.")

        elif choice == "3":
            action_name = input("Enter action name: ")
            action_description = input("Enter action description: ")
            new_action = Action(action_name, action_description, len(Petri.actions))
            Petri.add_action(new_action)
            print(f"Action '{action_name}' added.")

        elif choice == "4":
            place_name = input("Enter place name: ")
            ficha_count = int(input("Enter number of fichas to add: "))
            Petri.add_ficha(place_name, ficha_count)
            print(f"Fichas added to place '{place_name}'.")

        elif choice == "5":
            Petri.show_attributes()

        elif choice == "6":
            print("Exiting...")
            break

        else:
            print("Invalid choice. Please try again.")